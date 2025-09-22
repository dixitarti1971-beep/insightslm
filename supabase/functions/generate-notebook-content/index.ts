
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { notebookId, filePath, sourceType } = await req.json()

    if (!notebookId || !sourceType) {
      return new Response(
        JSON.stringify({ error: 'notebookId and sourceType are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Processing request:', { notebookId, filePath, sourceType });

    // Get environment variables
    const webServiceUrl = Deno.env.get('NOTEBOOK_GENERATION_URL')
    const authHeader = Deno.env.get('NOTEBOOK_GENERATION_AUTH')

    if (!webServiceUrl || !authHeader) {
      console.error('Missing environment variables:', {
        hasUrl: !!webServiceUrl,
        hasAuth: !!authHeader
      })
      console.error('Configuration Error: Required environment variables missing. Please add NOTEBOOK_GENERATION_URL and NOTEBOOK_GENERATION_AUTH to your Supabase Edge Function secrets.')
      
      return new Response(
        JSON.stringify({ 
          error: 'Web service configuration missing',
          details: 'Required environment variables NOTEBOOK_GENERATION_URL and/or NOTEBOOK_GENERATION_AUTH are missing from Supabase Edge Function secrets.',
          configurationHelp: 'Please add these secrets in your Supabase project settings under Edge Functions > Secrets. Refer to README.md setup instructions, step 5.'
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Update notebook status to 'generating'
    await supabaseClient
      .from('notebooks')
      .update({ generation_status: 'generating' })
      .eq('id', notebookId)

    console.log('Calling external web service...')

    // Prepare payload based on source type
    let payload: any = {
      sourceType: sourceType
    };

    if (filePath) {
      // For file sources (PDF, audio) or URLs (website, YouTube)
      payload.filePath = filePath;
    } else {
      // For text sources, we need to get the content from the database
      const { data: source } = await supabaseClient
        .from('sources')
        .select('content')
        .eq('notebook_id', notebookId)
        .single();
      
      if (source?.content) {
        payload.content = source.content.substring(0, 5000); // Limit content size
      }
    }

    console.log('Sending payload to web service:', payload);

    // Call external web service
    const response = await fetch(webServiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      console.error('N8N Web Service Error:', response.status, response.statusText)
      const errorText = await response.text();
      console.error('N8N Error Response:', errorText);
      
      // Parse the error to provide better feedback
      let configurationHelp = '';
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.message && errorJson.message.includes('not registered')) {
          configurationHelp = 'The n8n workflow webhook is not active. Please activate the "InsightsLM - Generate Notebook Details" workflow in your n8n instance by toggling the Active switch in the top-right corner of the workflow editor.';
        }
      } catch (e) {
        configurationHelp = 'Please ensure your n8n workflows are active and properly configured. Check that the NOTEBOOK_GENERATION_URL points to an active n8n workflow webhook.';
      }
      
      // Update status to failed
      await supabaseClient
        .from('notebooks')
        .update({ generation_status: 'failed' })
        .eq('id', notebookId)

      return new Response(
        JSON.stringify({ 
          error: 'Failed to generate content from web service',
          details: errorText,
          configurationHelp: configurationHelp
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const generatedData = await response.json()
    console.log('Generated data:', generatedData)

    // Parse the response format: object with output property
    let title, description, notebookIcon, backgroundColor, exampleQuestions;
    
    if (generatedData && generatedData.output) {
      const output = generatedData.output;
      title = output.title;
      description = output.summary;
      notebookIcon = output.notebook_icon;
      backgroundColor = output.background_color;
      exampleQuestions = output.example_questions || [];
    } else {
      console.error('Unexpected response format:', generatedData)
      
      await supabaseClient
        .from('notebooks')
        .update({ generation_status: 'failed' })
        .eq('id', notebookId)

      return new Response(
        JSON.stringify({ error: 'Invalid response format from web service' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!title) {
      console.error('No title returned from web service')
      
      await supabaseClient
        .from('notebooks')
        .update({ generation_status: 'failed' })
        .eq('id', notebookId)

      return new Response(
        JSON.stringify({ error: 'No title in response from web service' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Update notebook with generated content including icon, color, and example questions
    const { error: notebookError } = await supabaseClient
      .from('notebooks')
      .update({
        title: title,
        description: description || null,
        icon: notebookIcon || '📝',
        color: backgroundColor || 'bg-gray-100',
        example_questions: exampleQuestions || [],
        generation_status: 'completed'
      })
      .eq('id', notebookId)

    if (notebookError) {
      console.error('Notebook update error:', notebookError)
      return new Response(
        JSON.stringify({ error: 'Failed to update notebook' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Successfully updated notebook with example questions:', exampleQuestions)

    return new Response(
      JSON.stringify({ 
        success: true, 
        title, 
        description,
        icon: notebookIcon,
        color: backgroundColor,
        exampleQuestions,
        message: 'Notebook content generated successfully' 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Edge function error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
